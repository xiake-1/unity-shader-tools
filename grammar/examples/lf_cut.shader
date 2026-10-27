Shader "Unlit/LambertFrag"
{
    Properties
    {
        _MainColor("MainColor",Color) = (1,1,1,1) 
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
           
            #include "UnityCG.cginc"
            #include "Lighting.cginc"

            fixed4 _MainColor;

            ENDCG
        }
    }
}
