Shader "Gate/Variants/FallbackTarget"
{
  SubShader
  {
    Pass
    {
      HLSLPROGRAM
      #pragma multi_compile_fwdbase
      float4 g(){return 1;}
      ENDHLSL
    }
  }
}
